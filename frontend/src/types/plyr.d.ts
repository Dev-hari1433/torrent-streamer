// Plyr 3.8.4's declaration combines `export =` with `export default` inside an
// ESM package. Describe the small ESM surface we use until upstream fixes it.
declare module 'plyr' {
  export default class Plyr {
    constructor(target: HTMLVideoElement, options?: {
      controls?: string[];
      ratio?: string;
      keyboard?: { focused: boolean; global: boolean };
    });
    destroy(): void;
  }
}
