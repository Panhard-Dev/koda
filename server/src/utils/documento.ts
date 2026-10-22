/**
 * CPF e CNPJ.
 *
 * O app já confere isto antes de acender o botão, mas **conferir lá não vale
 * aqui**: validação de cliente é conveniência, não garantia — qualquer um fala
 * direto com esta API. O que chega ao Mercado Pago sai daqui conferido.
 *
 * A conta é a dos **dígitos verificadores**, não a do comprimento. Onze dígitos
 * quaisquer passam por CPF para quem só conta dígitos, e é assim que entra
 * documento errado numa cobrança: quem cobra recusa depois, e a pessoa não
 * entende por quê.
 */

export function soDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * O `111.111.111-11` é recusado à parte porque ele **passa** na conta dos
 * verificadores — a sequência repetida fecha em qualquer módulo. E é
 * justamente o que todo mundo digita para testar.
 */
export function cpfValido(valor: string): boolean {
  const d = soDigitos(valor);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const corte of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < corte; i += 1) soma += Number(d[i]) * (corte + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(d[corte])) return false;
  }
  return true;
}

/** O CNPJ pela mesma ideia, com os pesos dele — que começam em 5 e dão a volta. */
export function cnpjValido(valor: string): boolean {
  const d = soDigitos(valor);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const pesos = [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ];
  for (let rodada = 0; rodada < 2; rodada += 1) {
    let soma = 0;
    const linha = pesos[rodada] as number[];
    for (let i = 0; i < linha.length; i += 1) soma += Number(d[i]) * (linha[i] as number);
    const resto = soma % 11;
    const verificador = resto < 2 ? 0 : 11 - resto;
    if (verificador !== Number(d[12 + rodada])) return false;
  }
  return true;
}

/** CPF ou CNPJ — o que o Mercado Pago chama de `identification.type`. */
export function tipoDocumento(valor: string): 'CPF' | 'CNPJ' | null {
  const d = soDigitos(valor);
  if (cpfValido(d)) return 'CPF';
  if (cnpjValido(d)) return 'CNPJ';
  return null;
}
