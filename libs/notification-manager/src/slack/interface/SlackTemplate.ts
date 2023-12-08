export abstract class SlackTemplate {
  abstract message(): Record<string, unknown>;
}
