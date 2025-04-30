declare module 'http-digest-client' {
  export default class DigestClient {
    constructor(username: string, password: string);
    request(
      options: any,
      body: string,
      callback: (res: {
        on: (event: string, callback: (chunk: string) => void) => void;
      }) => void
    ): void;
  }
}
