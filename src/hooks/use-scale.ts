import { useCallback, useEffect, useRef, useState } from "react";

// Live connection to the ESP32/HX711 food scale over Web Serial.
//
// The firmware (hardware_src/scale/scale.ino) streams one weight
// reading per line at 115200 baud (~10/sec) and accepts single-char commands:
//   t          tare (replies "tared")
//   f<number>  set calibration factor
//   p          print calibration factor
// Numeric lines are weights; anything else is firmware chatter.

export type ScaleState = {
  /** Whether this browser exposes the Web Serial API (Chrome/Edge, HTTPS or localhost). */
  supported: boolean;
  /** Whether a scale is currently open and streaming. */
  connected: boolean;
  /** Latest weight in grams, or null before the first reading. */
  weight: number | null;
  /** Prompt the user to pick a serial port and start streaming. Must run from a
   * click. Resolves true once the port is open, false if cancelled or failed. */
  connect: () => Promise<boolean>;
  /** Close the port and stop streaming. */
  disconnect: () => Promise<void>;
  /** Zero the scale on the hardware (sends the firmware `t` command). */
  tare: () => Promise<void>;
};

export function useScale(): ScaleState {
  const [supported, setSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [weight, setWeight] = useState<number | null>(null);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readLoopRef = useRef<Promise<void> | null>(null);
  const keepReadingRef = useRef(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && !!navigator.serial);
  }, []);

  const readLoop = useCallback(async (port: SerialPort) => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (port.readable && keepReadingRef.current) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            // Numeric lines are weights; anything else is firmware chatter.
            if (/^-?[\d.]+$/.test(trimmed)) {
              setWeight(Math.round(parseFloat(trimmed)));
            }
          }
        }
      } catch {
        // Read error (e.g. device unplugged) — fall through and clean up.
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    keepReadingRef.current = false;

    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch {
        // ignore
      }
    }
    if (readLoopRef.current) {
      try {
        await readLoopRef.current;
      } catch {
        // ignore
      }
      readLoopRef.current = null;
    }
    if (writerRef.current) {
      try {
        writerRef.current.releaseLock();
      } catch {
        // ignore
      }
      writerRef.current = null;
    }
    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch {
        // ignore
      }
      portRef.current = null;
    }

    setConnected(false);
    setWeight(null);
  }, []);

  // Open an already-obtained port and start streaming. Shared by the user-gesture
  // `connect()` path and the silent auto-reconnect on mount.
  const openPort = useCallback(
    async (port: SerialPort) => {
      try {
        await port.open({ baudRate: 115200 });
        portRef.current = port;

        if (port.writable) {
          writerRef.current = port.writable.getWriter();
        }

        keepReadingRef.current = true;
        setConnected(true);
        readLoopRef.current = readLoop(port);
        return true;
      } catch {
        // Open failed (e.g. already in use) — leave everything closed.
        await disconnect();
        return false;
      }
    },
    [readLoop, disconnect],
  );

  const connect = useCallback(async () => {
    if (!navigator.serial) return false;
    try {
      // requestPort must run inside the click handler (user gesture).
      const port = await navigator.serial.requestPort();
      return await openPort(port);
    } catch {
      // Port selection cancelled — nothing to clean up.
      return false;
    }
  }, [openPort]);

  const tare = useCallback(async () => {
    const writer = writerRef.current;
    if (!writer) return;
    try {
      await writer.write(new TextEncoder().encode("t\n"));
    } catch {
      // ignore
    }
  }, []);

  // On mount, silently reconnect to a scale the user has already authorized.
  // getPorts() needs no user gesture, so this works on page load; the first-ever
  // pairing still goes through connect()/requestPort() from a click. Plugging the
  // device in later fires the "connect" event, which reconnects it too.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serial) return;
    const serial = navigator.serial;
    let cancelled = false;

    const reconnect = async () => {
      try {
        const ports = await serial.getPorts();
        if (!cancelled && ports.length > 0 && !portRef.current) {
          await openPort(ports[0]);
        }
      } catch {
        // No authorized ports or reconnect failed — wait for a manual connect.
      }
    };

    void reconnect();
    serial.addEventListener("connect", reconnect);
    return () => {
      cancelled = true;
      serial.removeEventListener("connect", reconnect);
    };
  }, [openPort]);

  // Release the port when the consuming component unmounts.
  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  return { supported, connected, weight, connect, disconnect, tare };
}
