'use strict';

const BIOMETRIC_ASSET_RELEASE = '20260731-lifecycle-recovery';

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-biometric-flow.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/operaciones/portal/offline.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
