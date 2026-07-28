'use strict';

(() => {
  const HUMAN_VERSION = '3.3.6';
  const HUMAN_CDN_SCRIPT = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/dist/human.js`;
  const HUMAN_CDN_MODELS = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}/models/`;
  const proxyNamespace = {};
  let runtimePromise = null;

  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = HUMAN_CDN_SCRIPT;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.addEventListener('load', () => {
        const runtime = window.Human;
        if (!runtime?.Human || runtime === proxyNamespace) {
          reject(new Error('human_cdn_runtime_invalid'));
          return;
        }
        resolve(runtime);
      }, { once: true });
      script.addEventListener('error', () => reject(new Error('human_cdn_runtime_unavailable')), { once: true });
      document.head.appendChild(script);
    });
    return runtimePromise;
  }

  class HumanCdnProxy {
    constructor(config = {}) {
      this.config = {
        ...config,
        modelBasePath: HUMAN_CDN_MODELS
      };
      this.runtime = null;
      this.instancePromise = loadRuntime().then((runtime) => {
        this.runtime = runtime;
        return new runtime.Human(this.config);
      });
    }

    async load(...args) {
      const instance = await this.instancePromise;
      return instance.load(...args);
    }

    async detect(...args) {
      const instance = await this.instancePromise;
      return instance.detect(...args);
    }
  }

  proxyNamespace.Human = HumanCdnProxy;
  proxyNamespace.version = HUMAN_VERSION;
  window.Human = proxyNamespace;
})();
