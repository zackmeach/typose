import { yamlModel, type YamlModel } from './yaml-model'
let model: YamlModel | undefined
self.onmessage = (event: MessageEvent) => {
  const { id, method, bytes, encoding, container, start, count } = event.data
  try {
    let result: unknown
    if (method === 'build') {
      const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0
      const source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
      model = yamlModel(source, encoding, bom); result = { root: model.root, problems: model.problems }
    }
    else if (method === 'children' && model) result = model.children(container, start, count)
    else throw new Error('YAML worker unavailable')
    self.postMessage({ id, result })
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
}
