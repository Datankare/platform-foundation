# platform/features

Optional-feature availability (ADR-050 D3, TASK-104). A feature whose settings are absent is not
offered: the UI asks `GET /api/features` and hides it, and the feature's route refuses with
`feature.not_configured` (501) instead of failing with "please try again".

## Files

| File              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `availability.ts` | Each feature and what it needs; `featureAvailability()` (booleans only) |
| `guard.ts`        | `requireFeature(id, { request })` for the feature's route               |

## Features

| Id                     | Needs                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `music_identification` | `SONG_ID_PROVIDER=acrcloud` + ACRCloud credentials, and a real audio converter                |
| `audio_upload`         | A speech key (`GOOGLE_API_KEY`) and a real audio converter (`AUDIO_CONVERTER=ffmpeg-service`) |
| `speech_input`         | A speech key (`GOOGLE_API_KEY`)                                                               |
| `teams`                | Nothing — offered as a **preview** (sample data) until TASK-108 defines participation         |

SSO providers join this list with the Cognito hosted sign-in (7A C2).
