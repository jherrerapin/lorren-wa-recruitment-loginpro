import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = fs.readFileSync(new URL('../mobile/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const adaptiveIcon = fs.readFileSync(new URL('../mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../mobile/android/app/src/main/res/drawable/ic_launcher_background.xml', import.meta.url), 'utf8');
const foreground = fs.readFileSync(new URL('../mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml', import.meta.url), 'utf8');
const portalIcon = fs.readFileSync(new URL('../src/public/worker-portal-icon.svg', import.meta.url), 'utf8');


test('el APK declara un launcher propio y no cae en el icono genérico de Android', () => {
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/);
  assert.match(adaptiveIcon, /<adaptive-icon/);
  assert.match(adaptiveIcon, /@drawable\/ic_launcher_background/);
  assert.match(adaptiveIcon, /@drawable\/ic_launcher_foreground/);
});


test('el launcher Android conserva la identidad visual del icono PWA', () => {
  assert.match(portalIcon, /#176c36/i);
  assert.match(portalIcon, /#bde8cb/i);
  assert.match(portalIcon, /M151 122h72v202h138v66H151V122Z/);
  assert.match(portalIcon, /m330 166 14 14 29-34/);

  assert.match(background, /#176C36/i);
  assert.match(foreground, /#BDE8CB/i);
  assert.match(foreground, /M151,122h72v202h138v66H151V122Z/);
  assert.match(foreground, /M330,166l14,14l29,-34/);
  assert.match(foreground, /android:strokeColor="#176C36"/i);
});


test('la adaptación Android usa recursos vectoriales y no introduce otro branding binario', () => {
  assert.match(foreground, /<vector/);
  assert.match(background, /<shape/);
  assert.doesNotMatch(`${adaptiveIcon}\n${background}\n${foreground}`, /\.png|\.webp|\.jpg|base64/i);
});
