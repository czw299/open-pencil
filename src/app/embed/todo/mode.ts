/** The Todo host owns document identity, persistence and lifecycle in this mode. */
import { IS_BROWSER } from '@/constants'

export const isTodoEmbed =
  IS_BROWSER && new URLSearchParams(window.location.search).get('embed') === 'todo'
