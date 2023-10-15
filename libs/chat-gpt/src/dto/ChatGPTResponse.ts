export class ChatGPTResponse {
  constructor(private content: string | null) {}

  get isNoMessage(): boolean {
    return !this.content;
  }

  get answer() {
    return this.content || '';
  }
}
