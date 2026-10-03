// Local upload is a product capability, independent of administration/publication.
export function canUploadLocalFiles(role: string): boolean {
  return role === "OWNER" || role === "PARTNER";
}
