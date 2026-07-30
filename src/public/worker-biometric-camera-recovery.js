'use strict';

(() => {
  const previousApi = window.LorrenWorkerBiometric;
  if (!previousApi) return;

  const CAMERA_READY_TIMEOUT_MS = 9_000;

  function installCameraLayout() {
    if (document.getElementById('lorren-biometric-camera-layout')) return;
    const style = document.createElement('style');
    style.id = 'lorren-biometric-camera-layout';
    style.textContent = `
      .face-stage {
        background: #05090c !important;
      }
      .face-stage video,
      .face-stage .photo-preview {
        object-fit: contain !important;
        background: #05090c !important;
      }
      .face-frame {
        top: 50% !important;
        width: 84% !important;
        height: 88% !important;
        border-radius: 24px !important;
        border-width: 3px !important;
        box-shadow: 0 0 0 999px rgba(0, 0, 0, .14) !important;
      }
      @media (max-width: 760px) {
        #camera-step {
          padding: 6px !important;
        }
        #camera-step .face-stage,
        #enrollment-dialog .face-stage {
          width: 100% !important;
          max-width: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }

  function resetVideo(video) {
    try { video.pause(); } catch { /* El navegador puede no haber iniciado reproducción. */ }
    video.srcObject = null;
    video.removeAttribute('src');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.muted = true;
    video.autoplay = true;
    video.hidden = false;
    try { video.load(); } catch { /* Algunos WebView no implementan load de forma completa. */ }
  }

  function renderedFrameCount(video) {
    try {
      return Number(video.getVideoPlaybackQuality?.().totalVideoFrames || 0);
    } catch {
      return 0;
    }
  }

  async function waitForFirstFrame(video, stream, timeoutMs = CAMERA_READY_TIMEOUT_MS) {
    const track = stream.getVideoTracks?.()[0];
    if (!track || track.readyState !== 'live') throw new Error('camera_stream_unavailable');

    await new Promise((resolve, reject) => {
      let settled = false;
      let frameCallbackId = null;
      const timeout = window.setTimeout(() => finish(new Error('camera_stream_unavailable')), timeoutMs);
      const interval = window.setInterval(check, 120);

      function cleanup() {
        window.clearTimeout(timeout);
        window.clearInterval(interval);
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
        video.removeEventListener('error', fail);
        track.removeEventListener('ended', fail);
        if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(frameCallbackId);
        }
      }

      function finish(error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }

      function fail() {
        finish(new Error('camera_stream_unavailable'));
      }

      function check() {
        if (track.readyState !== 'live') return fail();
        const dimensionsReady = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
        const frameReady = renderedFrameCount(video) > 0 || (!video.paused && video.currentTime > 0);
        if (dimensionsReady && frameReady) finish();
      }

      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.addEventListener('error', fail, { once: true });
      track.addEventListener('ended', fail, { once: true });

      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallbackId = video.requestVideoFrameCallback(() => finish());
      }
      check();
    });
  }

  async function openStream(video, constraints) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    try {
      resetVideo(video);
      video.srcObject = stream;
      await video.play();
      await waitForFirstFrame(video, stream);
      return stream;
    } catch (error) {
      stopStream(stream);
      resetVideo(video);
      throw error;
    }
  }

  async function startCamera(video) {
    if (!video || !navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
    resetVideo(video);

    const attempts = [
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 720 },
          height: { ideal: 960 }
        },
        audio: false
      },
      { video: { facingMode: 'user' }, audio: false },
      { video: true, audio: false }
    ];

    let lastError = null;
    for (const constraints of attempts) {
      try {
        return await openStream(video, constraints);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('camera_stream_unavailable');
  }

  installCameraLayout();
  window.LorrenWorkerBiometric = Object.freeze({
    ...previousApi,
    startCamera
  });
})();
