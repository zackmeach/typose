import { yamlModel, type YamlModel } from './yaml-model'
let model: YamlModel | undefined
self.onmessage = (event: MessageEvent) => {
  const { id, method, source, encoding, bom, container, start, count } = event.data
  try {
    let result: unknown
    if (method === 'build') { model = yamlModel(source, encoding, bom); result = { root: model.root, problems: model.problems } }
    else if (method === 'children' && model) result = model.children(container, start, count)
    else throw new Error('YAML worker unavailable')
    self.postMessage({ id, result })
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
}
