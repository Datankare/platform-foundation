export interface ProcessRequest {
  text: string;
}

export interface Translation {
  language: string;
  languageCode: string;
  flag: string;
  text: string;
  audioBase64: string;
}

export interface ProcessResponse {
  success: boolean;
  translations?: Translation[];
  error?: string;
}

export interface SafetyResult {
  safe: boolean;
  reason?: string;
}
