'use strict';

const BIOMETRIC_ASSET_VERSION = '20260729-r4';

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-portal-hardening.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/public/worker-biometric-accessibility.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
document.write(`<script src="/operaciones/portal/offline.js?v=${BIOMETRIC_ASSET_VERSION}"><\/script>`);
