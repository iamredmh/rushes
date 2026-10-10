// No import of any kind (test/core/shared-with-web.test.ts checks): the dashboard's level slider
// bundles this file, so it uses the server's own range and step.
// §19.6: a Mix lane's level, in dB. −24..6 in 0.5 dB steps; PUT /api/picks enforces the range and
// step (a value outside it, or off the step, is a 400), so the stored file is never checked again here.
export const LEVEL_MIN = -24;
export const LEVEL_MAX = 6;
export const LEVEL_STEP = 0.5;
