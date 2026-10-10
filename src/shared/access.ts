export interface AccessStatus { enabled: boolean; credentialRequired: boolean; version: number }
export interface AccessPrincipal { id: string; label: string; role: 'admin' | 'member'; operateOthers: boolean; allowedRoots: string[]; revoked?: boolean }
export interface AccessCredentialResult { principal: AccessPrincipal; credential: string }
export interface AccessUserInput { label: string; role: 'admin' | 'member'; operateOthers: boolean; allowedRoots: string[] }
export type AccessIdentity = AccessPrincipal | { role: 'legacy'; label: string }
