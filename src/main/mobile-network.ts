export function isPrivateLanIPv4(address: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false
  const parts = address.split('.').map(Number)
  return parts.every((part) => part <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))
}
