package dev.crow.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Runs on the UI thread. Values never cross the Capacitor/JavaScript bridge. */
final class PangolinPrompt {
    interface Completion { void finish(JSONObject auth); }
    static AlertDialog show(Activity activity, JSONObject endpoint, Completion completion) throws Exception {
        String origin = EndpointPolicy.origin(endpoint);
        LinearLayout form = new LinearLayout(activity); form.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = new ScrollView(activity); scroll.setFillViewport(true); scroll.addView(form);
        int pad = (int) (20 * activity.getResources().getDisplayMetrics().density); form.setPadding(pad, pad, pad, pad);
        TextView domain = new TextView(activity); domain.setText("Destino exacto: " + origin + "\nHTTPS con CA válida. Compará con Windows. Usá sólo el token de ESTE recurso, nunca claves admin/Newt."); form.addView(domain);
        EditText id = field(activity, form, "ID del token del recurso", 128), token = field(activity, form, "Token del recurso", 1024);
        CheckBox confirmed = new CheckBox(activity); confirmed.setText("El dominio coincide con Windows y este token corresponde a ese recurso"); form.addView(confirmed);
        AtomicBoolean finished = new AtomicBoolean();
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle("Autenticación Pangolin").setView(scroll).setPositiveButton("Vincular", null).setNegativeButton("Cancelar", null).create();
        dialog.setOnDismissListener(ignored -> { id.setText(""); token.setText(""); if (finished.compareAndSet(false, true)) completion.finish(null); });
        dialog.setOnShowListener(ignored -> {
            dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            // Dialog-owned window only; no Activity flag is changed or left behind on dismissal.
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                if (!confirmed.isChecked()) { confirmed.setError("Confirmá el dominio exacto antes de enviar."); confirmed.requestFocus(); scroll.smoothScrollTo(0, confirmed.getTop()); return; }
                try {
                    JSONObject auth = PangolinAuth.credentials(endpoint, id.getText().toString(), token.getText().toString());
                    if (finished.compareAndSet(false, true)) { id.setText(""); token.setText(""); dialog.dismiss(); completion.finish(auth); }
                } catch (Exception invalid) { token.setError("ID/token inválido: sin espacios, saltos ni caracteres fuera de ASCII."); token.requestFocus(); scroll.smoothScrollTo(0, token.getTop()); }
            });
        });
        dialog.show(); return dialog;
    }
    private static EditText field(Activity activity, LinearLayout form, String label, int max) {
        EditText field = new EditText(activity); field.setId(View.generateViewId());
        TextView name = new TextView(activity); name.setText(label); name.setLabelFor(field.getId()); form.addView(name);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); field.setSingleLine(true); field.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});
        field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); field.setSaveEnabled(false); field.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        form.addView(field); return field;
    }
}
