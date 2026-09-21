// Display analytics only. Warmup is null; no estimates or future samples.
function validate(values, period) {
  if (!Number.isInteger(period) || period < 1 || period > 500) throw new Error("Period must be an integer between 1 and 500");
  if (!Array.isArray(values) || values.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new Error("Finite prices required");
}
export function sma(values, period) {
  validate(values, period);
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= period) sum -= values[i - period];
    return i < period - 1 ? null : sum / period;
  });
}
export function ema(values, period) {
  validate(values, period);
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let mean = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = mean;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { mean += alpha * (values[i] - mean); result[i] = mean; }
  return result;
}
export function bollinger(values, period, deviations = 2) {
  const middle = sma(values, period), upper = [], lower = [];
  if (!Number.isFinite(deviations) || deviations <= 0 || deviations > 10) throw new Error("Invalid deviation multiplier");
  for (let i = 0; i < values.length; i++) {
    if (middle[i] === null) { upper.push(null); lower.push(null); continue; }
    const variance = values.slice(i - period + 1, i + 1).reduce((sum, v) => sum + (v - middle[i]) ** 2, 0) / period;
    const spread = deviations * Math.sqrt(variance);
    upper.push(middle[i] + spread); lower.push(middle[i] - spread);
  }
  return { middle, upper, lower };
}
export function rsi(values, period) {
  validate(values, period);
  const result = Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1], up = Math.max(0, delta), down = Math.max(0, -delta);
    if (i <= period) { gain += up / period; loss += down / period; }
    else { gain = (gain * (period - 1) + up) / period; loss = (loss * (period - 1) + down) / period; }
    if (i >= period) result[i] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return result;
}
