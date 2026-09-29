/**
 * The two calls the flash dialog and canvas make into a native (Tauri)
 * shell, which can list and flash USB serial ports. This fork ships no
 * native shell, so in the browser `isTauri()` is false and no ports are
 * listed; the code paths stay for anyone wrapping the web build in one.
 */

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function tauriInvoke(): TauriInvoke | null {
  const t = (window as { __TAURI__?: { core?: { invoke?: TauriInvoke }; invoke?: TauriInvoke } })
    .__TAURI__;
  return t?.core?.invoke ?? t?.invoke ?? null;
}

export function isTauri(): boolean {
  return tauriInvoke() !== null;
}

/** A USB serial port as the native shell reports it. */
export interface SerialPortInfo {
  path: string;
  vid?: number | null;
  pid?: number | null;
  manufacturer?: string | null;
  product?: string | null;
  serial_number?: string | null;
}

/** USB serial ports on the host; empty outside a native shell. */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const invoke = tauriInvoke();
  if (!invoke) return [];
  try {
    return await invoke<SerialPortInfo[]>('list_serial_ports');
  } catch (err) {
    console.warn('[native] list_serial_ports failed:', err);
    return [];
  }
}
