// Minimal Web Serial API declarations — the DOM lib doesn't ship these yet.
// Only the surface the scale integration touches is declared.
// Ported from the food-scale firmware host app (C:\hackxperience).

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface Serial {
  requestPort(): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
