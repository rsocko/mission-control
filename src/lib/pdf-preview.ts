const PDF_FIT_WIDTH_PARAMETER = 'zoom=page-width';

export function withPdfFitToWidth(url: string): string {
  const hashIndex = url.indexOf('#');
  const baseUrl = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const parameters = hashIndex === -1
    ? []
    : url.slice(hashIndex + 1).split('&').filter(Boolean);
  const retainedParameters = parameters.filter(
    (parameter) => !/^zoom(?:=|$)/i.test(parameter),
  );

  return `${baseUrl}#${[...retainedParameters, PDF_FIT_WIDTH_PARAMETER].join('&')}`;
}
