type RuntimeRef = { channel: any; config: any; [key: string]: any }

let runtime: RuntimeRef | null = null

export const setRelayRuntime = (rt: RuntimeRef): void => {
  runtime = rt
}

export const getRelayRuntime = (): RuntimeRef => {
  if (!runtime) throw new Error("Relay plugin runtime not initialized")
  return runtime
}
