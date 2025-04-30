declare module 'http-digest-client' {
  export default class DigestClient {
    constructor(username: string, password: string);

    request(
      options: {
        host: string;
        port: number;
        path: string;
        method: string;
        headers?: Record<string, string>;
      },
      body: string,
      callback: (res: NodeJS.ReadableStream) => void
    ): void;
  }
}
