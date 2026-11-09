// A stand-in for pdf-worker.ts that never answers: the parse of a PDF that spins forever.
self.onmessage = () => {
  while (true) {
    // busy loop: only a terminate() ends it
  }
}
