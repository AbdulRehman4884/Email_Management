/**
 * src/lib/agentFileFilter.ts
 *
 * multer fileFilter for files attached in the agent chat: only CSV / Excel. A wrong file used to be
 * dropped silently (cb(null, false)) and the message went on as if nothing was attached, so the user
 * never learned why (QA P4 bug 11). Now the request fails with a clear 400.
 */
import { ValidationError } from "./errors.js";

export function agentFileFilter(
  _req: unknown,
  file: { originalname: string },
  cb: (error: Error | null, accept?: boolean) => void,
): void {
  if (/\.(csv|xlsx|xls)$/i.test(file.originalname)) {
    cb(null, true);
    return;
  }
  cb(new ValidationError(`Only CSV or Excel files (.csv, .xlsx, .xls) are supported — "${file.originalname}" was not used. Please attach a CSV or Excel file.`));
}
