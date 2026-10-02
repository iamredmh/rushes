/** Read SSE text from a running server until `needle` appears. */
export async function sse(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  };
  return { until, stop: () => ctrl.abort(), text: () => text };
}
