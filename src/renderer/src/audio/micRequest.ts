/**
 * Awaits a microphone request (getUserMedia). Opening the mic can take a while (a Bluetooth
 * headset switching to its mic profile takes about a second), and the owner may be gone by then,
 * e.g. the editor was closed. In that case the stream is released at once and `null` comes back,
 * so nothing starts a recorder on a stream nobody will ever stop.
 */
export async function acquireMic(request: () => Promise<MediaStream>, isDisposed: () => boolean): Promise<MediaStream | null> {
  const stream = await request()
  if (isDisposed()) {
    stream.getTracks().forEach((tr) => tr.stop())
    return null
  }
  return stream
}
