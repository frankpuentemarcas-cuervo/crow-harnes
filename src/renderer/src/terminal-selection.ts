export class PendingTerminalSelection {
  private text = ''

  capture(current: string): boolean {
    if (current) this.text = current
    return this.text.length > 0
  }

  read(current: string): string {
    return current || this.text
  }

  clear(): void {
    this.text = ''
  }

  hasText(): boolean {
    return this.text.length > 0
  }
}
