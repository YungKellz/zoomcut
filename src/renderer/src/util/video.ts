/**
 * Seeks a <video> and resolves once the new frame is actually presented. The `seeked`
 * event alone can fire while drawImage would still paint the previous frame.
 */
export function seekVideo(video: HTMLVideoElement, ms: number, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    const target = ms / 1000
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    const afterSeek = (): void => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish())
        window.setTimeout(finish, 250)
      } else {
        window.setTimeout(finish, 40)
      }
    }
    if (Math.abs(video.currentTime - target) < 0.0005) {
      afterSeek()
      return
    }
    video.addEventListener('seeked', afterSeek, { once: true })
    video.currentTime = target
    window.setTimeout(finish, timeoutMs)
  })
}

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= 1) resolve()
    else video.addEventListener('loadedmetadata', () => resolve(), { once: true })
  })
}
