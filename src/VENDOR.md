# Third-party code in this add-on

The add-on's own code is MIT-licensed, plain JavaScript, shipped as written. It ships one
third-party library, unmodified: libheif-js 1.23.5, the Emscripten build of libheif 1.23.5 that
decodes HEIC and HEIF photos on the user's computer, for "Fit attachments for sending". Its
WebAssembly binary is inside the JavaScript module, as the release publishes it. The add-on
loads it only when a HEIC photo is made smaller (lib/heic.js imports it then); it makes no
network request and uses no eval or new Function.

directory: vendor/libheif-js
source: https://cdn.jsdelivr.net/npm/libheif-js@1.23.5/
licence: LGPL-3.0 (the texts are vendor/libheif-js/LICENSE and vendor/libheif-js/libheif-wasm/LICENSE)
homepage: https://github.com/catdad-experiments/libheif-js
npm package: https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.5.tgz
npm integrity: sha512-umXZPthnWZtF3iG/5mQG+AZ2V6i0UeYpo3z2CkggTEgL8dKmIIwJT6TDuAMuabXa1yTW8uJ1ZAgR+CxNTklYYw==
git tag: 1.23.5 (commit d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d)
webassembly build: https://github.com/catdad-experiments/libheif-emscripten/releases/tag/v1.23.5
libheif release: https://github.com/strukturag/libheif/releases/tag/v1.23.5

The files keep the paths they have in the npm package (under its package/ folder). Their
SHA-256, the same as in the package:

- `vendor/libheif-js/libheif-wasm/libheif-bundle.mjs`: `095194187be00d3e36335b8ad7f5552d70655e5e2159486d7d36cd4daa47bba9`
- `vendor/libheif-js/libheif-wasm/LICENSE`: `fa81ce652315b013359d6e8e4744335f31a50c7c192907176d3632f78a3b4596`
- `vendor/libheif-js/LICENSE`: `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`

The library is a separate file, loaded as it is; anyone may replace it with another build of the
same release (the LGPL's terms). To check it: download the npm package above, unpack it and
compare the three files byte for byte.
