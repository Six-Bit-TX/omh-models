import { TYPERT as permission } from '../permission-presets/lib/typert.host.js'

export const name = 'omh-models-rpc-schemas'
export const inject = ['typert']

/** Path-mounted owners need explicit generated RPC schema registration. */
export function apply(ctx) {
  ctx.effect(() => ctx.typert.register(permission), 'omh-models: permission schemas')
}
