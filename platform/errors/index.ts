/**
 * platform/errors — API error codes and the message catalog (ADR-051)
 *
 * @module platform/errors
 */

export {
  ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isAppErrorCode,
  isErrorCode,
  messageKey,
} from "./registry";
export type {
  ErrorCode,
  ErrorCodeSpec,
  ErrorParamKind,
  ErrorParamSpec,
} from "./registry";
export { apiError, apiErrorBody, errorFromResult, internalError } from "./respond";
export type { ApiErrorBody, ApiErrorOptions, CodedFailure, ErrorParams } from "./respond";
export {
  APP_NAMESPACES,
  CATALOGS,
  DEFAULT_LOCALE,
  availableLocales,
  catalogKeys,
  lookup,
  mergeCatalogs,
  negotiateLocale,
  renderMessage,
} from "./messages";
export type { Catalog, MessageValues } from "./messages";
export { renderApiErrorsDoc, renderAppApiErrorsDoc } from "./doc";
