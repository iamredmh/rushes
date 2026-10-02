/** Read SSE text from a running server until `needle` appears. */
export async function sse(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pull = async () => {
    const { value, done } = await reader.read();
    if (done) return false;
    text += decoder.decode(value);
    return true;
  };
  const until = async (needle: string) => {
    while (!text.includes(needle)) if (!(await pull())) break;
    return text;
  };
  /** Like until(), but for a needle already seen once: waits for it to appear again, after what's read so far. */
  const untilNext = async (needle: string) => {
    const from = text.length;
    while (!text.slice(from).includes(needle)) if (!(await pull())) break;
    return text;
  };
  return { until, untilNext, stop: () => ctrl.abort(), text: () => text };
}
