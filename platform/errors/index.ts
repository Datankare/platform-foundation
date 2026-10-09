/**
 * platform/errors — API error codes and the message catalog (ADR-051)
 *
 * @module platform/errors
 */

export { ERROR_CODES, isErrorCode, messageKey } from "./registry";
export type {
  ErrorCode,
  ErrorCodeSpec,
  ErrorParamKind,
  ErrorParamSpec,
} from "./registry";
export { apiError, apiErrorBody, errorFromResult, internalError } from "./respond";
export type { ApiErrorBody, ApiErrorOptions, CodedFailure, ErrorParams } from "./respond";
export {
  CATALOGS,
  DEFAULT_LOCALE,
  availableLocales,
  catalogKeys,
  lookup,
  negotiateLocale,
  renderMessage,
} from "./messages";
export type { Catalog, MessageValues } from "./messages";
export { renderApiErrorsDoc } from "./doc";
