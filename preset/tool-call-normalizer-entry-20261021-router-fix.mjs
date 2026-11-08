// 20261021-router-fix: argument normalization, edit recovery hints, and the
// tightened bash TTY/timeout hints (the low-precision five-call batch hint was
// removed after adversarial review). Fresh entry PATH + release URL so a
// running host does not keep the prior normalizer graph.
export { name, inject, apply } from './tool-call-normalizer.mjs?release=20261021-router-fix'
