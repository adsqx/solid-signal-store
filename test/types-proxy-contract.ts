import { createSolidStore, type SolidStoreProxy } from '../src';

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
