# platform/features

Optional-feature availability (ADR-050 D3, TASK-104). A feature whose settings are absent is not
offered: the UI asks `GET /api/features` and hides it, and the feature's route refuses with
`feature.not_configured` (501) instead of failing with "please try again".

## Files

| File              | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `availability.ts` | The core's features, composed with the modules'; `featureAvailability()` (booleans only) |
| `guard.ts`        | `requireFeature(id, { request })` for the feature's route                                |

## Features

The core declares its own features (`CORE_FEATURE_REQUIREMENTS`); a product module declares the
features it adds in its definition (`features`, ADR-054 D4), and they are offered only when the app
registers the module. `listFeatureRequirements()` is the whole list (the core's first);
`isFeatureAvailable` and `requireFeature` refuse a feature no registered module declares
(`feature.not_configured`).

| Id                                         | Declared by | Needs                                                                                         |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| `sso_google`, `sso_apple`, `sso_microsoft` | core        | Cognito with its hosted sign-in domain and the provider in `SSO_PROVIDERS` (7A C2)            |
| `music_identification`                     | song-id     | `SONG_ID_PROVIDER=acrcloud` + ACRCloud credentials, and a real audio converter                |
| `audio_upload`                             | voice       | A speech key (`GOOGLE_API_KEY`) and a real audio converter (`AUDIO_CONVERTER=ffmpeg-service`) |
| `speech_input`                             | voice       | A speech key (`GOOGLE_API_KEY`)                                                               |
| `teams`                                    | social      | Nothing — offered as a **preview** (sample data) until TASK-108 defines participation         |
