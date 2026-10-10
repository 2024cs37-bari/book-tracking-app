/**
 * Network boundary for original-file transfer (docs/BACKEND.md §6, STORAGE.md
 * §6–7). Books themselves do not travel through the metadata sync protocol;
 * their bytes move directly between the client and private R2, authorized by
 * the Worker. Keeping this an interface lets the transfer engine's logic be
 * verified against an in-memory fake, exactly as the metadata SyncEngine is.
 *
 * The baseline is a single authorized PUT/GET per object. The durable queue row
 * already carries a multipart `uploadId`/`partState`, so a chunked flow can be
 * added later behind this same interface without touching the engine's
 * state-machine.
 */

/** A short-lived authorization to transfer one object. Never persisted. */
export interface TransferTicket {
  /** Short-lived URL (or opaque handle) the client uses for the byte transfer. */
  readonly url: string;
}

export interface UploadAuthorization {
  /**
   * True when the server already holds this object (deduplicated by hash): the
   * client skips the byte transfer and only confirms availability.
   */
  readonly alreadyAvailable: boolean;
  /** The upload ticket; absent when `alreadyAvailable` is true. */
  readonly ticket?: TransferTicket;
}

export interface FileTransport {
  /**
   * Declares an upload (hash + size) and gets authorization. The server may
   * report the object already exists, in which case no bytes are sent.
   */
  beginUpload(sha256: string, sizeBytes: number): Promise<UploadAuthorization>;
  /** Sends the whole object to private storage using the ticket. */
  upload(ticket: TransferTicket, body: Blob): Promise<void>;
  /**
   * Confirms the upload: the server verifies object existence/size (and
   * checksum where supported) and only then publishes availability.
   */
  finishUpload(sha256: string, sizeBytes: number): Promise<void>;
  /** Authorizes a download of an existing object, returning a fetch ticket. */
  beginDownload(sha256: string): Promise<TransferTicket>;
  /** Fetches the object bytes using the ticket. */
  download(ticket: TransferTicket): Promise<Blob>;
}
