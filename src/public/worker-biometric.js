'use strict';

const BIOMETRIC_ASSET_VERSION = '20260730-mobile-camera-v3';

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-biometric-camera-recovery.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-portal-hardening.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-portal-biometric-flow.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/operaciones/portal/offline.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
