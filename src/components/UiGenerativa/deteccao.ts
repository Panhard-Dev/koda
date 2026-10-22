/** Reconhece quando o modelo escreveu a DSL visual dentro de uma cerca `js`. */
const COMPONENTES_UI =
  /<(?:box|card|row|column|grid|title|texto|paragrafo|label|caption|icon|divider|spacer|button|iconbutton|pressable|link|slider|input|textarea|select|radio|segmented|checkbox|toggle|date|form|table|chart|stat|list|badge|alert|progress|callout|steps|tabs|accordion|carousel|popover|repeat|code|imagem)\b/i

/**
 * A marca `{@body}` + `DIL.useState/useList` é exclusiva da mini-linguagem do Koda.
 * Se o modelo errar só o rótulo da cerca (`js` em vez de `koda-ui`), o conteúdo ainda
 * pode passar pelo interpretador fechado. Código JS comum continua como código.
 */
export function pareceCodigoDeUi(idioma: string, codigo: string): boolean {
  if (!/^(?:js|javascript|jsx|tsx)$/i.test(idioma.trim())) return false
  return (
    /^\s*\{@body\b/.test(codigo) &&
    /\bDIL\.(?:useState|useList)\s*\(/.test(codigo) &&
    COMPONENTES_UI.test(codigo)
  )
}
