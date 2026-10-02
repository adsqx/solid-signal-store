import { createSolidStore, type Draft, type SolidStoreProxy } from '../src';

type Post = {
  title: string;
  tags: string[];
};

type State = {
  user: {
    name: string;
    posts: Post[];
  };
};

const api = createSolidStore<State>({
  user: {
    name: 'Ada',
    posts: [{ title: 'Hello', tags: ['solid'] }],
  },
}, 'solid_type_contract');

const store = api.store;
const returned: SolidStoreProxy<State> = api.returnStore();

const name: string = store.user.name();
const firstTitle: string = store.user.posts[0].title();
const firstTag: string = store.user.posts[0].tags[0]();
const pushedLength: number = store.user.posts.push({ title: 'Next', tags: [] });
const mappedTitles: string[] = store.user.posts.map((post) => post.title);

api.select((state) => state.user.posts[0].title()).subscribe((title: string) => {
  void title;
}).dispose();

api.setValue('user.name', 'Grace');

void returned;
void name;
void firstTitle;
void firstTag;
void pushedLength;
void mappedTitles;

// State declared as an interface (no index signature) is accepted.
interface IfaceSettings { theme: string; size: number }
const ifaceStore = createSolidStore<IfaceSettings>({ theme: 'dark', size: 1 }, 'iface-contract');
void ifaceStore;

// `$draft` / `SolidStore#draft`: the plain, deep-mutable data type — assignments typecheck like plain JSON.
const draft: Draft<State> = store.$draft;
const sameDraft: Draft<State> = api.draft;
draft.user.name = 'x';
// @ts-expect-error a number is not assignable to the string field
draft.user.name = 1;
// @ts-expect-error unknown keys are rejected
draft.user.nope = 'x';
draft.user.posts.push({ title: 'Typed', tags: ['t'] });
// @ts-expect-error array elements are typed
draft.user.posts.push({ title: 1, tags: [] });
draft.user.posts[0].tags[0] = 'solid';
const draftTitle: string = draft.user.posts[0].title;
const foundPost: Post | undefined = api.draft.user.posts.find((post) => post.title === 'Hello');
store.user.$draft.name = 'nested view';
const frozen: Draft<{ readonly a: readonly { readonly b: number }[] }> = { a: [{ b: 1 }] };
frozen.a[0].b = 2;
frozen.a.push({ b: 3 });

void sameDraft;
void draftTitle;
void foundPost;
