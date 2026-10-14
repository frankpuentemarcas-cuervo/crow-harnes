package dev.crow.companion;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import org.json.JSONObject;

/** Signing identity only: private material never leaves AndroidKeyStore. Hardware backing is not assumed. */
final class DeviceSigningKey {
    private static KeyStore keys() throws Exception { KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); return keys; }
    static void generate(String alias) throws Exception {
        if (keys().containsAlias(alias)) throw new IllegalStateException("La identidad del dispositivo ya existe.");
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
        generator.generateKeyPair();
    }
    static boolean exists(String alias) throws Exception { return keys().containsAlias(alias); }
    static String publicKey(String alias) throws Exception { return Base64.encodeToString(keys().getCertificate(alias).getPublicKey().getEncoded(), Base64.NO_WRAP); }
    static void delete(String alias) throws Exception { keys().deleteEntry(alias); }
    static String signChallenge(String alias, JSONObject challenge, String gatewayId, String deviceId) throws Exception {
        if (!gatewayId.matches("[A-Za-z0-9._~-]{1,128}") || !deviceId.matches("[A-Za-z0-9._~-]{1,128}")) throw new IllegalArgumentException("Identidad de vínculo inválida.");
        java.util.Iterator<String> fields = challenge.keys();
        while (fields.hasNext()) if (!fields.next().matches("version|gatewayId|deviceId|challengeId|nonce|expiresAt")) throw new IllegalArgumentException("Challenge incompatible.");
        if (challenge.getInt("version") != 2 || !gatewayId.equals(challenge.getString("gatewayId")) || !deviceId.equals(challenge.getString("deviceId"))) throw new IllegalArgumentException("El challenge no corresponde a este vínculo.");
        String challengeId = challenge.getString("challengeId"), nonce = challenge.getString("nonce");
        if (!challengeId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") || !nonce.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Challenge inválido.");
        Instant now = Instant.now(), expires = Instant.parse(challenge.getString("expiresAt"));
        if (!expires.isAfter(now) || expires.isAfter(now.plusSeconds(31))) throw new IllegalArgumentException("El challenge venció o su vigencia es inválida.");
        String payload = "crow-mobile-renew:v2\n" + gatewayId + "\n" + deviceId + "\n" + challengeId + "\n" + nonce;
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign((PrivateKey) keys().getKey(alias, null));
        signature.update(payload.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }
}
