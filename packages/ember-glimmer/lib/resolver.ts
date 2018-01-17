import {
  ComponentDefinition,
  Opaque,
  Option,
  RuntimeResolver as IRuntimeResolver,
  VMHandle,
  ComponentCapabilities
} from '@glimmer/interfaces';
import { LazyOpcodeBuilder, Macros, OpcodeBuilderConstructor, ParsedLayout, TemplateOptions, WrappedBuilder } from '@glimmer/opcode-compiler';
import { LazyConstants, Program } from '@glimmer/program';
import {
  getDynamicVar,
  Helper,
  ModifierManager,
  PartialDefinition
} from '@glimmer/runtime';
import { privatize as P } from 'container';
import { assert } from 'ember-debug';
import { _instrumentStart } from 'ember-metal';
import { LookupOptions, Owner, setOwner } from 'ember-utils';
import {
  lookupComponent,
  lookupPartial,
  OwnedTemplateMeta,
} from 'ember-views';
import { EMBER_GLIMMER_TEMPLATE_ONLY_COMPONENTS, GLIMMER_CUSTOM_COMPONENT_MANAGER } from 'ember/features';
import CompileTimeLookup from './compile-time-lookup';
import { CURLY_CAPABILITIES, CurlyComponentDefinition } from './component-managers/curly';
import { TemplateOnlyComponentDefinition } from './component-managers/template-only';
import { isHelperFactory, isSimpleHelper } from './helper';
import { default as classHelper } from './helpers/-class';
import { default as htmlSafeHelper } from './helpers/-html-safe';
import { default as inputTypeHelper } from './helpers/-input-type';
import { default as normalizeClassHelper } from './helpers/-normalize-class';
import { default as action } from './helpers/action';
import { default as concat } from './helpers/concat';
import { default as eachIn } from './helpers/each-in';
import { default as get } from './helpers/get';
import { default as hash } from './helpers/hash';
import { inlineIf, inlineUnless } from './helpers/if-unless';
import { default as log } from './helpers/log';
import { default as mut } from './helpers/mut';
import { default as queryParams } from './helpers/query-param';
import { default as readonly } from './helpers/readonly';
import { default as unbound } from './helpers/unbound';
import ActionModifierManager from './modifiers/action';
import { populateMacros } from './syntax';
import { mountHelper } from './syntax/mount';
import { outletHelper } from './syntax/outlet';
import { renderHelper } from './syntax/render';
import { Factory as TemplateFactory, Injections, OwnedTemplate } from './template';
import { ClassBasedHelperReference, SimpleHelperReference } from './utils/references';

function instrumentationPayload(name: string) {
  return { object: `component:${name}` };
}

function makeOptions(moduleName: string) {
  return moduleName !== undefined ? { source: `template:${moduleName}`} : undefined;
}

const BUILTINS_HELPERS = {
  'if': inlineIf,
  action,
  concat,
  get,
  hash,
  log,
  mut,
  'query-params': queryParams,
  readonly,
  unbound,
  'unless': inlineUnless,
  '-class': classHelper,
  '-each-in': eachIn,
  '-input-type': inputTypeHelper,
  '-normalize-class': normalizeClassHelper,
  '-html-safe': htmlSafeHelper,
  '-get-dynamic-var': getDynamicVar,
  '-mount': mountHelper,
  '-outlet': outletHelper,
  '-render': renderHelper,
};

const BUILTIN_MODIFIERS = {
  action: new ActionModifierManager(),
};

export default class RuntimeResolver implements IRuntimeResolver<OwnedTemplateMeta> {
  public templateOptions: TemplateOptions<OwnedTemplateMeta> = {
    program: new Program<OwnedTemplateMeta>(new LazyConstants(this)),
    macros: new Macros(),
    resolver: new CompileTimeLookup(this),
    Builder: LazyOpcodeBuilder as OpcodeBuilderConstructor,
  };

  private handles: any[] = [
    undefined, // ensure no falsy handle
  ];
  private objToHandle = new WeakMap<any, number>();

  private builtInHelpers: {
    [name: string]: Helper | undefined;
  } = BUILTINS_HELPERS;

  private builtInModifiers: {
    [name: string]: ModifierManager<Opaque>;
  } = BUILTIN_MODIFIERS;

  constructor() {
    populateMacros(this.templateOptions.macros);
  }

  /***  IRuntimeResolver ***/

  /**
   * Called while executing Append Op.PushDynamicComponentManager if string
   */
  lookupComponent(name: string, meta: OwnedTemplateMeta): Option<ComponentDefinition> {
    let handle = this.lookupComponentDefinition(name, meta);
    if (handle === null) {
      assert(`Could not find component named "${name}" (no component or template with that name was found)`);
      return null;
    }
    return this.resolve(handle);
  }

  /**
   * Called by RuntimeConstants to lookup unresolved handles.
   */
  resolve<U>(handle: number): U {
    return this.handles[handle];
  }
  // End IRuntimeResolver

  /**
   * Called by CompileTimeLookup compiling Unknown or Helper OpCode
   */
  lookupHelper(name: string, meta: OwnedTemplateMeta): Option<number> {
    let handle = this._lookupHelper(name, meta);
    if (handle !== null) {
      return this.handle(handle);
    }
    return null;
  }

  /**
   * Called by CompileTimeLookup compiling the Component OpCode
   */
  lookupComponentDefinition(name: string, meta: OwnedTemplateMeta): Option<number> {
    return this.handle(this._lookupComponentDefinition(name, meta));
  }

  /**
   * Called by CompileTimeLookup compiling the
   */
  lookupModifier(name: string, _meta: OwnedTemplateMeta): Option<number> {
    return this.handle(this._lookupModifier(name));
  }

  /**
   * Called by CompileTimeLookup to lookup partial
   */
  lookupPartial(name: string, meta: OwnedTemplateMeta): Option<number> {
    let partial = this._lookupPartial(name, meta);
    return this.handle(partial);
  }

  // end CompileTimeLookup

  // TODO implement caching for the follow hooks

  /**
   * Creates a directly imported template with injections.
   * @param templateFactory the direct imported template factory
   * @param owner the owner to set
   */
  createTemplate(factory: TemplateFactory, owner: Owner) {
    const injections: Injections = { options: this.templateOptions };
    setOwner(injections, owner);
    // TODO cache by owner and template.id
    return factory.create(injections);
  }

  /**
   * Returns a wrapped layout for the specified layout.
   * @param template the layout to wrap.
   */
  getWrappedLayout(template: OwnedTemplate, capabilities: ComponentCapabilities) {
    const compileOptions = Object.assign({},
      this.templateOptions, { asPartial: false, referrer: template.referrer});
    // TODO fix this getting private
    const parsed: ParsedLayout<OwnedTemplateMeta> = (template as any).parsedLayout;
    // TODO cache by template instance and capabilities
    return new WrappedBuilder(compileOptions, parsed, capabilities);
  }

  // needed for lazy compile time lookup
  private handle(obj: any | null | undefined) {
    if (obj === undefined || obj === null) {
      return null;
    }
    let handle: number | undefined = this.objToHandle.get(obj);
    if (handle === undefined) {
      handle = this.handles.push(obj) - 1;
      this.objToHandle.set(obj, handle);
    }
    return handle;
  }

  private _lookupHelper(name: string, meta: OwnedTemplateMeta): Option<Helper> {
    const helper = this.builtInHelpers[name];
    if (helper !== undefined) {
      return helper;
    }

    const { owner, moduleName } = meta;

    const options: LookupOptions | undefined = makeOptions(moduleName);

    const factory = owner.factoryFor(`helper:${name}`, options) || owner.factoryFor(`helper:${name}`);

    if (!isHelperFactory(factory)) {
      return null;
    }

    if (isSimpleHelper(factory)) {
      const helper = factory.create().compute;
      return (_vm, args) => {
        return SimpleHelperReference.create(helper, args.capture());
      };
    }

    return (vm, args) => {
      const helper = factory.create();
      vm.newDestroyable(helper);
      return ClassBasedHelperReference.create(helper, args.capture());
    };
  }

  private _lookupPartial(name: string, meta: OwnedTemplateMeta): PartialDefinition {
    const template = lookupPartial(name, meta.owner);
    const partial = new PartialDefinition( name, lookupPartial(name, meta.owner));

    if (template) {
      return partial;
    } else {
      throw new Error(`${name} is not a partial`);
    }
  }

  private _lookupModifier(name: string) {
    let modifier = this.builtInModifiers[name];
    if (modifier !== undefined) {
      return modifier;
    }
    return null;
  }

  private _lookupComponentDefinition(name: string, meta: OwnedTemplateMeta): Option<ComponentDefinition> {
    let { layout, component } = lookupComponent(meta.owner, name, makeOptions(meta.moduleName));

    if (layout && !component && EMBER_GLIMMER_TEMPLATE_ONLY_COMPONENTS) {
      return new TemplateOnlyComponentDefinition(layout);
    }

    let customManager: any | undefined;
    if (GLIMMER_CUSTOM_COMPONENT_MANAGER) {
      let managerId = layout && layout.referrer.managerId;

      if (managerId) {
        customManager = meta.owner.factoryFor(`component-manager:${managerId}`);
      }
    }

    let finalizer = _instrumentStart('render.getComponentDefinition', instrumentationPayload, name);
    let layoutHandle = this.handle(layout) as Option<VMHandle>;
    let definition = (layout || component) ?
      new CurlyComponentDefinition(
        name,
        customManager,
        component || meta.owner.factoryFor(P`component:-default`),
        layoutHandle,
        layout
      ) : null;

    finalizer();
    return definition;
  }
}
