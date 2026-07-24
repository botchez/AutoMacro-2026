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
  /** Ports the user has already authorized — returned without a user gesture. */
  getPorts(): Promise<SerialPort[]>;
  addEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (event: Event) => void): void;
}

interface Navigator {
  readonly serial?: Serial;
}
