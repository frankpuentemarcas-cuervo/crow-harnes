package dev.crow.companion;

import org.json.JSONObject;
import org.json.JSONTokener;
import okhttp3.ResponseBody;

/** Maps the untrusted HTTP error body to fixed, user-facing copy. */
final class MobileErrorMessages {
    private static final int MAX_ERROR_BODY_BYTES = 8192;

    private MobileErrorMessages() {}

    static String fromResponse(int status, ResponseBody body, String crowMarker) {
        String fallback = "Crow rechazó la acción (HTTP " + status + "). Verificá el estado antes de repetirla.";
        if (!"1".equals(crowMarker)) return fallback;
        if (body == null) return fallback;
        try {
            okio.BufferedSource source = body.source();
            okio.Buffer buffer = new okio.Buffer();
            long remaining = MAX_ERROR_BODY_BYTES + 1L;
            while (remaining > 0) {
                long read = source.read(buffer, remaining);
                if (read == -1) break;
                remaining -= read;
            }
            if (buffer.size() > MAX_ERROR_BODY_BYTES) return fallback;
            JSONTokener tokener = new JSONTokener(buffer.readUtf8());
            Object parsed = tokener.nextValue();
            if (tokener.nextClean() != 0) return fallback;
            if (!(parsed instanceof JSONObject)) return fallback;
            Object codeValue = ((JSONObject) parsed).opt("code");
            if (!(codeValue instanceof String)) return fallback;
            return message((String) codeValue, status);
        } catch (Exception invalidOrOversized) {
            return fallback;
        }
    }

    private static String message(String code, int status) {
        switch (code) {
            case "INVALID_ORIGIN": return "Crow no autorizó este origen. Revisá el endpoint configurado en Windows.";
            case "GATEWAY_UNAVAILABLE": return "Crow Gateway no está disponible. Verificá que esté activo en Windows.";
            case "HOST_UNAVAILABLE": return "El host está desconectado. Reconectalo en Windows y verificá el estado antes de repetir la acción.";
            case "DEVICE_REJECTED": return "Crow rechazó la autenticación del dispositivo. Revisá el vínculo y los permisos en Windows; verificá el estado antes de repetir la acción.";
            case "GRANT_REQUIRED": return "Este dispositivo no tiene permiso para esa acción. Ajustá sus permisos en Crow en Windows; el perfil no se modificó.";
            case "RATE_LIMITED": return "Crow limitó temporalmente las solicitudes. Esperá antes de volver a intentar y verificá el estado si era una acción.";
            case "NOT_FOUND": return "El recurso ya no está disponible. Actualizá la vista antes de continuar.";
            case "INVALID_REQUEST": return "Crow no aceptó la solicitud. Verificá los datos y el estado antes de repetirla.";
            case "REQUEST_CONFLICT": return "La solicitud entra en conflicto con el estado actual. Actualizá y verificá el resultado antes de intentar de nuevo.";
            default: return "Crow rechazó la acción (HTTP " + status + "). Verificá el estado antes de repetirla.";
        }
    }
}
