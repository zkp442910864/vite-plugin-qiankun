import * as cheerio from 'cheerio'
import { Cheerio, CheerioAPI } from 'cheerio'
import { PluginOption } from 'vite'

type Element = ReturnType<ReturnType<typeof cheerio.load>> extends Cheerio<infer T> ? T : never

const createQiankunHelper = (qiankunName: string) => `
  const createDeffer = (hookName) => {
    const d = new Promise((resolve, reject) => {
      window.proxy && (window.proxy[\`vite\${hookName}\`] = resolve)
    })
    return props => d.then(fn => fn(props));
  }
  const bootstrap = createDeffer('bootstrap');
  const mount = createDeffer('mount');
  const unmount = createDeffer('unmount');
  const update = createDeffer('update');

  ;(global => {
    global.qiankunName = '${qiankunName}';
    global['${qiankunName}'] = {
      bootstrap,
      mount,
      unmount,
      update
    };
  })(window);
`

// eslint-disable-next-line no-unused-vars
const replaceSomeScript = ($: CheerioAPI, findStr: string, replaceStr: string = '') => {
  $('script').each((i, el) => {
    if ($(el).html()?.includes(findStr)) {
      $(el).html(replaceStr)
    }
  })
}

const createImportFinallyResolve = (qiankunName: string) => {
  return `
    const qiankunLifeCycle = window.moudleQiankunAppLifeCycles && window.moudleQiankunAppLifeCycles['${qiankunName}'];
    if (qiankunLifeCycle) {
      window.proxy.vitemount((props) => qiankunLifeCycle.mount(props));
      window.proxy.viteunmount((props) => qiankunLifeCycle.unmount(props));
      window.proxy.vitebootstrap(() => qiankunLifeCycle.bootstrap());
      window.proxy.viteupdate((props) => qiankunLifeCycle.update(props));
    }
  `
}

export type MicroOption = {
  useDevMode?: boolean
}
type PluginFn = (qiankunName: string, microOption?: MicroOption) => PluginOption;

const htmlPlugin: PluginFn = (qiankunName, microOption = {}) => {
  let isProduction: boolean
  let base = ''

  const module2DynamicImport = ($: CheerioAPI, scriptTag: Element) => {
    if (!scriptTag) {
      return
    }
    const script$ = $(scriptTag)
    const moduleSrc = script$.attr('src')
    let appendBase = ''
    if (microOption.useDevMode && !isProduction) {
      appendBase = '(window.proxy ? (window.proxy.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ + \'..\') : \'\') + '
    }
    script$.removeAttr('src')
    script$.removeAttr('type')
    script$.html(`import(${appendBase}'${moduleSrc}')`)
    return script$
  }

  const handleReactRefresh = ($: CheerioAPI, scriptTag: Cheerio<Element>) => {
    if (!scriptTag.length) {
      return
    }
    const content = scriptTag.html() || ''
    scriptTag.html('')
    scriptTag.attr('src', '/@react-refresh')
    const newScriptTag = module2DynamicImport($, scriptTag[0])!
    const newContent = newScriptTag.html()
    newScriptTag.html(`
      ${newContent}.then((mod) => {
        ${content.replace(/import (\w+) from "(.*)"/, 'const $1 = mod.default')}
      })
    `)
  }

  return {
    name: 'qiankun-html-transform',
    order: 'post',
    enforce: 'post',
    configResolved (config) {
      isProduction = config.command === 'build' || config.isProduction
      base = config.base
    },

    configureServer (server) {
      return () => {
        server.middlewares.use((req, res, next) => {
          if (isProduction || !microOption.useDevMode) {
            next()
            return
          }
          const end = res.end.bind(res)
          res.end = (...args: any[]) => {
            let [htmlStr, ...rest] = args
            if (typeof htmlStr === 'string') {
              const $ = cheerio.load(htmlStr)
              module2DynamicImport($, $(`script[src=${base}@vite/client]`).get(0)!)
              htmlStr = $.html()
            }
            end(htmlStr, ...rest)
          }
          next()
        })
      }
    },
    transformIndexHtml (html: string) {
      const $ = cheerio.load(html)
      const moduleTags = $('body script[type=module], head script[crossorigin=""]')
      if (!moduleTags || !moduleTags.length) {
        return
      }
      const len = moduleTags.length
      moduleTags.each((i, moduleTag) => {
        const script$ = module2DynamicImport($, moduleTag)
        if (len - 1 === i) {
          script$?.html(`${script$.html()}.finally(() => {
            ${createImportFinallyResolve(qiankunName)}
          })`)
        }
      })

      // type wwt = ReturnType<typeof $>
      handleReactRefresh($, $('head script[type=module]:contains("/@react-refresh")'))

      $('body').append(`<script>${createQiankunHelper(qiankunName)}</script>`)
      const output = $.html()
      return output
    }
  }
}

export default htmlPlugin
