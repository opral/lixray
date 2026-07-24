export function summarizeSamples(samples) {
  if (samples.length === 0) {
    throw new Error("at least one sample is required");
  }

  const elapsed = samples
    .map((sample) => sample.elapsedMs)
    .sort((left, right) => left - right);
  return {
    minMs: elapsed[0],
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: elapsed.at(-1),
    meanMs: mean(elapsed),
    meanRequestBytes: mean(samples.map((sample) => sample.requestBytes)),
    meanResponseBytes: mean(samples.map((sample) => sample.responseBytes)),
  };
}

export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    throw new Error("percentile requires at least one value");
  }
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error("percentile fraction must be in (0, 1]");
  }
  return sortedValues[Math.ceil(sortedValues.length * fraction) - 1];
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
