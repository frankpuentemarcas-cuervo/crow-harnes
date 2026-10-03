package server

import (
	"regexp"
	"strings"
)

var attentionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:i need you to|i need your help to|please|could you|can you|would you)\s+(?:please\s+)?(?:confirm|choose|decide|approve|authorize|provide|share|tell me|answer|select|review|run|push|merge|commit|change|add|update|fix|create|deploy|continue)\b`),
	regexp.MustCompile(`(?i)\b(?:i need|i require) your\s+(?:answer|input|approval|confirmation|decision|choice|credentials|api key|token|password)\b`),
	regexp.MustCompile(`(?i)\b(?:i(?:'m| am) waiting for|waiting on|awaiting)\s+(?:your\s+)?(?:answer|response|input|approval|confirmation|decision)\b`),
	regexp.MustCompile(`(?i)\b(?:i cannot|i can't|i am unable to|i'm unable to|blocked)\s+(?:continue|proceed|move forward)\s+(?:until|without)\s+(?:you|your)\b`),
	regexp.MustCompile(`(?i)\b(?:which|what)\s+(?:option|alternative|approach|value|name)\s+(?:do you prefer|should i use|would you like me to use|do you want me to use)\b`),
	regexp.MustCompile(`(?i)\b(?:do you want me to|would you like me to|should i)\s+(?:continue|proceed|apply|delete|replace|deploy|run|choose|use|review|push|merge|commit|change|add|update|fix|create|edit|investigate)\b`),
	regexp.MustCompile(`(?i)\b(?:necesito|requiero)\s+(?:que\s+)?(?:me\s+)?(?:confirmes|indiques|elijas|decidas|apruebes|autorices|proporciones|compartas|respondas)\b`),
	regexp.MustCompile(`(?i)\b(?:puedes|podr[ií]as|pod[eé]s)\s+(?:confirmar|elegir|decidir|aprobar|autorizar|indicar|compartir|responder|revisar|mirar|ejecutar|validar|cambiar|agregar|subir|desplegar|continuar)\b`),
	regexp.MustCompile(`(?i)\bnecesito (?:tu|el|la)\s+(?:token|contrase[nñ]a|clave|credenciales|confirmaci[oó]n|aprobaci[oó]n|respuesta|decisi[oó]n)\b`),
	regexp.MustCompile(`(?i)\b(?:estoy esperando|quedo a la espera|necesito tu|me falta tu)\s+(?:de\s+)?(?:tu\s+|su\s+)?(?:respuesta|confirmaci[oó]n|aprobaci[oó]n|decisi[oó]n|indicaci[oó]n|autorizaci[oó]n|opini[oó]n)\b`),
	regexp.MustCompile(`(?i)\b(?:no puedo|no es posible|estoy bloqueado|qued[oó] bloqueado)\s+(?:continuar|proceder|avanzar)\s+(?:hasta que|sin)\s+(?:me\s+)?(?:confirmes|indiques|elijas|decidas|apruebes|autorices|respondas)\b`),
	regexp.MustCompile(`(?i)\b(?:cu[aá]l|qu[eé])\s+(?:opci[oó]n|alternativa|enfoque|valor|nombre)\s+(?:prefieres|prefer[ií]s|eleg[ií]s|debo usar|quieres que use|quer[eé]s que use)\b`),
	regexp.MustCompile(`(?i)\b(?:quieres que|quer[eé]s que|te gustar[ií]a que)\s+(?:(?:lo|la|te)\s+)?(?:contin[uú]e|proceda|aplique|elimine|reemplace|despliegue|ejecute|use|revise|investigue|agregue|cambie|arregle|haga)\b`),
}

var codeBlockPattern = regexp.MustCompile("(?s)```.*?```")
var quotedLinePattern = regexp.MustCompile(`(?m)^\s*>.*$`)
var negatedRulePattern = regexp.MustCompile(`(?i)\b(?:no|not|don't|doesn't|didn't|never|sin|tampoco)(?:\s+\w+){0,4}\s*$`)

// requiresAttention applies local phrase rules, not a second AI model. A
// question mark by itself is intentionally not considered an attention signal.
func requiresAttention(message string) bool {
	message = strings.TrimSpace(message)
	if message == "" {
		return false
	}
	message = codeBlockPattern.ReplaceAllString(message, " ")
	message = quotedLinePattern.ReplaceAllString(message, " ")
	if len([]rune(message)) > 12000 {
		message = string([]rune(message)[:12000])
	}
	for _, pattern := range attentionPatterns {
		for _, match := range pattern.FindAllStringIndex(message, -1) {
			start := match[0] - 64
			if start < 0 {
				start = 0
			}
			if negatedRulePattern.MatchString(message[start:match[0]]) {
				continue
			}
			return true
		}
	}
	return false
}
