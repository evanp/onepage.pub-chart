import { describe, before, after, it } from 'node:test'
import { exec } from 'node:child_process'
import assert from 'node:assert'
import querystring from 'node:querystring'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

const delay = t => new Promise(resolve => setTimeout(resolve, t))

const startServer = (port = 3000) => {
  return new Promise((resolve, reject) => {
    const server = exec(`OPP_PORT=${port} node index.mjs`)
    server.on('error', reject)
    server.stdout.on('data', (data) => {
      if (data.toString().includes('Listening')) {
        resolve(server)
      }
      console.log(`SERVER ${port}: ${data.toString()}`)
    })
    server.stderr.on('data', (data) => { console.log(`SERVER ${port} ERROR: ${data.toString()}`) })
  })
}

const registerUser = (() => {
  let i = 100
  return async (port = 3000) => {
    i++
    const username = `testuser${i}`
    const password = `testpassword${i}`
    const reg = await fetch(`https://localhost:${port}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: querystring.stringify({ username, password, confirmation: password })
    })
    const text = await reg.text()
    const token = text.match(/<span class="token">(.*?)<\/span>/)[1]
    return [username, token]
  }
})()

const registerActor = async (port = 3000) => {
  const [username, token] = await registerUser(port)
  const res = await fetch(`https://localhost:${port}/.well-known/webfinger?resource=acct:${username}@localhost:${port}`)
  const obj = await res.json()
  const actorId = obj.links[0].href
  const actorRes = await fetch(actorId)
  const actor = await actorRes.json()
  return [actor, token]
}

const doActivity = async (actor, token, activity) => {
  const res = await fetch(actor.outbox.id, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/activity+json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(activity)
  })
  if (res.status !== 200) {
    const body = await res.text()
    throw new Error(`Bad status code ${res.status}: ${body}`)
  }
  return await res.json()
}

describe('Web API interface', () => {
  let child = null

  before(async () => {
    child = await startServer(3000)
  })

  after(() => {
    child.kill()
  })

  describe('Root object', () => {
    it('can get the root object', async () => {
      const res = await fetch('https://localhost:3000/')
      const obj = await res.json()
      assert.strictEqual(obj.type, 'Service')
      assert.strictEqual(obj.name, 'One Page Pub')
      assert.strictEqual(obj.id, 'https://localhost:3000/')
    })
  })

  describe('Registration', () => {
    it('can get a registration form', async () => {
      const res = await fetch('https://localhost:3000/register')
      const body = await res.text()
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'text/html; charset=utf-8')
      assert(body.includes('<form'))
      assert(body.includes('name="username"'))
      assert(body.includes('name="password"'))
      assert(body.includes('name="confirmation"'))
    })

    it('can register a user', async () => {
      const username = 'testuser1'
      const password = 'testpassword1'
      const res = await fetch('https://localhost:3000/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify({ username, password, confirmation: password })
      })
      const body = await res.text()
      assert.strictEqual(res.status, 200, `Bad status code ${res.status}: ${body}`)
      assert.strictEqual(res.headers.get('Content-Type'), 'text/html; charset=utf-8')
      assert(body.includes('Registered'))
      assert(body.includes(username))
      assert(body.match('<span class="token">.+?</span>'))
    })
  })

  describe('Webfinger', () => {
    let username = null
    before(async () => {
      [username] = await registerUser()
    })
    it('can get information about a user', async () => {
      const res = await fetch(`https://localhost:3000/.well-known/webfinger?resource=acct:${username}@localhost:3000`)
      if (res.status !== 200) {
        const body = await res.text()
        console.log(body)
      }
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/jrd+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.subject, `acct:${username}@localhost:3000`)
      assert.strictEqual(obj.links[0].rel, 'self')
      assert.strictEqual(obj.links[0].type, 'application/activity+json')
      assert(obj.links[0].href.startsWith('https://localhost:3000/person/'))
    })
  })

  describe('Actor endpoint', () => {
    let username = null
    let actorId = null
    let actorRes = null
    let actorBody = null
    let actorObj = null

    before(async () => {
      [username] = await registerUser()
      const res = await fetch(`https://localhost:3000/.well-known/webfinger?resource=acct:${username}@localhost:3000`)
      const obj = await res.json()
      actorId = obj.links[0].href
      actorRes = await fetch(actorId)
      actorBody = await actorRes.text()
      actorObj = (actorRes.status === 200) ? JSON.parse(actorBody) : null
    })

    it('can fetch the actor endpoint', async () => {
      assert.strictEqual(actorRes.status, 200, `Bad status code ${actorRes.status}: ${actorBody}`)
      assert.strictEqual(actorRes.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
    })

    it('has the as2 @context', () => {
      assert(actorObj['@context'])
      assert.notEqual(-1, actorObj['@context'].indexOf('https://www.w3.org/ns/activitystreams'))
    })

    it('has the security @context', () => {
      assert(actorObj['@context'])
      assert.notEqual(-1, actorObj['@context'].indexOf('https://w3id.org/security'))
    })

    it('has the blocked @context', () => {
      assert(actorObj['@context'])
      assert(actorObj['@context'].includes('https://purl.archive.org/socialweb/blocked'))
    })

    it('has the correct id', () => {
      assert.strictEqual(actorObj.id, actorId)
    })

    it('has the correct type', () => {
      assert.strictEqual(actorObj.type, 'Person')
    })

    it('has the correct name', () => {
      assert.strictEqual(actorObj.name, username)
    })

    it('has a valid inbox', () => {
      assert.equal('object', typeof actorObj.inbox)
      assert.equal('string', typeof actorObj.inbox.id)
      assert(actorObj.inbox.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a valid outbox', () => {
      assert.equal('object', typeof actorObj.outbox)
      assert.equal('string', typeof actorObj.outbox.id)
      assert(actorObj.outbox.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a valid followers', () => {
      assert.equal('object', typeof actorObj.followers)
      assert.equal('string', typeof actorObj.followers.id)
      assert(actorObj.followers.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a valid following', () => {
      assert.equal('object', typeof actorObj.following)
      assert.equal('string', typeof actorObj.following.id)
      assert(actorObj.following.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a valid liked', () => {
      assert.equal('object', typeof actorObj.liked)
      assert.equal('string', typeof actorObj.liked.id)
      assert(actorObj.liked.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a blocked property', () => {
      assert.equal('object', typeof actorObj.blocked)
      assert.equal('string', typeof actorObj.blocked.id)
      assert(actorObj.blocked.id.startsWith('https://localhost:3000/orderedcollection/'))
    })

    it('has a public key', () => {
      assert(actorObj.publicKey)
      assert.equal('object', typeof actorObj.publicKey)
      assert.equal('string', typeof actorObj.publicKey.id)
      assert(actorObj.publicKey.id.startsWith('https://localhost:3000/key/'))
      assert.equal('string', typeof actorObj.publicKey.type)
      assert.equal('Key', actorObj.publicKey.type)
      assert.equal('string', typeof actorObj.publicKey.owner)
      assert.equal(actorObj.publicKey.owner, actorId)
    })
  })

  describe('Actor streams', () => {
    let actor = null
    let token = null
    let token2 = null
    before(async () => {
      [actor, token] = await registerActor();
      [, token2] = await registerActor()
    })
    it('can get actor inbox', async () => {
      const res = await fetch(actor.inbox.id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.inbox.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })
    it('can get actor outbox', async () => {
      const res = await fetch(actor.outbox.id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.outbox.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })
    it('can get actor followers', async () => {
      const res = await fetch(actor.followers.id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.followers.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })
    it('can get actor following', async () => {
      const res = await fetch(actor.following.id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.following.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })
    it('can get actor liked', async () => {
      const res = await fetch(actor.liked.id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.liked.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })

    it('cannot get actor blocked without authentication', async () => {
      const res = await fetch(actor.blocked.id)
      assert.strictEqual(res.status, 401)
    })

    it('cannot get actor blocked with other user authentication', async () => {
      const res = await fetch(actor.blocked.id, {
        headers: {
          Authorization: `Bearer ${token2}`
        }
      })
      assert.strictEqual(res.status, 403)
    })

    it('can get actor blocked with authentication', async () => {
      const res = await fetch(actor.blocked.id, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj = await res.json()
      assert.strictEqual(obj.id, actor.blocked.id)
      assert.strictEqual(obj.type, 'OrderedCollection')
      assert.strictEqual(obj.totalItems, 0)
      assert(obj.nameMap?.en)
      assert(obj.first)
      assert(obj.first.id.startsWith('https://localhost:3000/orderedcollectionpage/'))
    })
  })
  describe('Post to outbox', () => {
    let actor = null
    let token = null
    let res = null
    let body = null
    let obj = null

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'IntransitiveActivity',
      to: 'https://www.w3.org/ns/activitystreams#Public'
    }

    before(async () => {
      [actor, token] = await registerActor()
      res = await fetch(actor.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(activity)
      })
      body = await res.text()
      obj = JSON.parse(body)
    })
    it('has the correct HTTP response', async () => {
      assert.strictEqual(res.status, 200, `Bad status code ${res.status}: ${body}`)
      assert.strictEqual(res.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
    })

    it('has an object id', async () => {
      assert(obj.id)
    })

    it('has the correct object type', async () => {
      assert.strictEqual(obj.type, activity.type)
    })

    it('has the correct addressees', async () => {
      assert.strictEqual(obj.to.id, activity.to)
    })

    it("appears in the actor's inbox", async () => {
      const inbox = await (await fetch(actor.inbox.id)).json()
      const inboxPage = await (await fetch(inbox.first.id)).json()
      assert(inboxPage.orderedItems.some(act => act.id === obj.id))
    })

    it("appears in the actor's outbox", async () => {
      const outbox = await (await fetch(actor.outbox.id)).json()
      const outboxPage = await (await fetch(outbox.first.id)).json()
      assert(outboxPage.orderedItems.some(act => act.id === obj.id))
    })
  })

  describe('Filter collections', () => {
    let actor1 = null
    let token1 = null
    let token2 = null
    let activity = null
    before(async () => {
      [actor1, token1] = await registerActor();
      [, token2] = await registerActor()
      const input = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'IntransitiveActivity',
        to: [actor1.id]
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(input)
      })
      const body = await res.text()
      activity = JSON.parse(body)
    })

    it('author can see own private activity', async () => {
      const outbox = await (await fetch(actor1.outbox.id, {
        headers: {
          Authorization: `Bearer ${token1}`
        }
      })).json()
      const outboxPage = await (await fetch(outbox.first.id, {
        headers: {
          Authorization: `Bearer ${token1}`
        }
      })).json()
      assert(outboxPage.orderedItems.some(val => val.id === activity.id))
    })

    it('others cannot see a private activity', async () => {
      const outbox = await (await fetch(actor1.outbox.id, {
        headers: {
          Authorization: `Bearer ${token2}`
        }
      })).json()
      const outboxPage = await (await fetch(outbox.first.id, {
        headers: {
          Authorization: `Bearer ${token2}`
        }
      })).json()
      assert(outboxPage.orderedItems.every(val => val.id !== activity.id))
    })
  })

  describe('Remote delivery', () => {
    let remote = null
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    before(async () => {
      remote = await startServer(3001);
      [actor1, token1] = await registerActor(3000);
      [actor2, token2] = await registerActor(3001)
    })
    after(async () => {
      remote.kill()
    })

    it('sends to remote addressees', async () => {
      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'IntransitiveActivity',
        to: actor2.id
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(activity)
      })
      const body = await res.text()
      const obj = JSON.parse(body)
      await delay(1000)
      const inbox = await (await fetch(actor2.inbox.id, { headers: { Authorization: `Bearer ${token2}` } })).json()
      const inboxPage = await (await fetch(inbox.first.id, { headers: { Authorization: `Bearer ${token2}` } })).json()
      assert(inboxPage.orderedItems.some(act => act.id === obj.id))
    })

    it('receives from remote senders', async () => {
      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'IntransitiveActivity',
        to: actor1.id
      }
      const res = await fetch(actor2.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token2}`
        },
        body: JSON.stringify(activity)
      })
      const body = await res.text()
      const obj = JSON.parse(body)
      // Wait for delivery!
      await delay(1000)
      const inbox = await (await fetch(actor1.inbox.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const inboxPage = await (await fetch(inbox.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(inboxPage.orderedItems.some(act => act.id === obj.id))
    })
  })

  describe('Follow Activity', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    let activity = null
    let obj = null
    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Follow',
        object: actor2.id,
        to: ['https://www.w3.org/ns/activitystreams#Public', actor2.id]
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(activity)
      })
      const body = await res.text()
      obj = JSON.parse(body)
    })

    it("appears in the actor's inbox", async () => {
      const inbox1 = await (await fetch(actor1.inbox.id)).json()
      const inboxPage1 = await (await fetch(inbox1.first.id)).json()
      assert(inboxPage1.orderedItems.some(act => act.id === obj.id))
    })

    it("appears in the actor's outbox", async () => {
      const outbox1 = await (await fetch(actor1.outbox.id)).json()
      const outboxPage1 = await (await fetch(outbox1.first.id)).json()
      assert(outboxPage1.orderedItems.some(act => act.id === obj.id))
    })

    it("appears in the other's inbox", async () => {
      const inbox2 = await (await fetch(actor2.inbox.id)).json()
      const inboxPage2 = await (await fetch(inbox2.first.id)).json()
      assert(inboxPage2.orderedItems.some(act => act.id === obj.id))
    })

    it("puts the actor in the other's followers", async () => {
      const followers2 = await (await fetch(actor2.followers.id)).json()
      const followersPage2 = await (await fetch(followers2.first.id)).json()
      assert(followersPage2.orderedItems.some(val => val.id === actor1.id))
    })

    it("puts the other in the actor's following", async () => {
      const following1 = await (await fetch(actor1.following.id)).json()
      const followingPage1 = await (await fetch(following1.first.id)).json()
      assert(followingPage1.orderedItems.some(val => val.id === actor2.id))
    })

    it('distributes to the actor when the other posts to followers', async () => {
      const activity2 = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'IntransitiveActivity',
        to: actor2.followers
      }
      const res2 = await fetch(actor2.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token2}`
        },
        body: JSON.stringify(activity2)
      })
      const body2 = await res2.text()
      assert.strictEqual(res2.status, 200, `Bad status code ${res2.status}: ${body2}`)
      assert.strictEqual(res2.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj2 = JSON.parse(body2)
      const inbox1 = await (await fetch(actor1.inbox.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const inboxPage1 = await (await fetch(inbox1.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(inboxPage1.orderedItems.some(val => val.id === obj2.id))
    })

    it('distributes to the actor when the other posts to public', async () => {
      const activity2 = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'IntransitiveActivity',
        to: 'https://www.w3.org/ns/activitystreams#Public'
      }
      const res2 = await fetch(actor2.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token2}`
        },
        body: JSON.stringify(activity2)
      })
      const body2 = await res2.text()
      assert.strictEqual(res2.status, 200, `Bad status code ${res2.status}: ${body2}`)
      assert.strictEqual(res2.headers.get('Content-Type'), 'application/activity+json; charset=utf-8')
      const obj2 = JSON.parse(body2)
      const inbox1 = await (await fetch(actor1.inbox.id)).json()
      const inboxPage1 = await (await fetch(inbox1.first.id)).json()
      assert(inboxPage1.orderedItems.some(val => val.id === obj2.id))
    })
  })

  describe('Create Activity', () => {
    let actor1 = null
    let token1 = null
    let activity = null
    const content = 'My dog has fleas.'
    before(async () => {
      [actor1, token1] = await registerActor()
      const source = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          content
        }
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(source)
      })
      const body = await res.text()
      activity = JSON.parse(body)
    })
    it('has a new object ID', async () => {
      assert.equal('object', typeof activity.object)
      assert.equal('string', typeof activity.object.id)
    })
    it('can fetch the new note', async () => {
      assert.equal('object', typeof activity.object)
      assert.equal('string', typeof activity.object.id)
      const res = await fetch(activity.object.id, {
        headers: {
          Authorization: `Bearer ${token1}`
        }
      })
      assert.equal(200, res.status)
      const fetched = await res.json()
      assert.equal(activity.object?.id, fetched.id)
      assert.equal('Note', fetched.type)
      assert.equal(content, fetched.content)
      assert.equal('string', typeof fetched.published)
      assert.equal('string', typeof fetched.updated)
    })
  })

  describe('Update Activity', () => {
    let actor1 = null
    let token1 = null
    let created = null
    let updated = null
    const content = 'My dog has fleas.'
    const contentMap = {
      en: content,
      fr: 'Mon chien a des puces.'
    }
    before(async () => {
      [actor1, token1] = await registerActor()
      const source = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          content
        }
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(source)
      })
      created = await res.json()
      const updateSource = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Update',
        object: {
          id: created.object.id,
          content: null,
          contentMap
        }
      }
      const updateRes = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(updateSource)
      })
      updated = await updateRes.json()
    })
    it('has the same object id', async () => {
      assert.equal(created.object.id, updated.object.id)
    })
    it('has the previous type', async () => {
      assert.equal('Note', updated.object.type)
    })
    it('has the new property', async () => {
      assert('contentMap' in updated.object)
      assert.equal(contentMap.en, updated.object?.contentMap?.en)
      assert.equal(contentMap.fr, updated.object?.contentMap?.fr)
    })
    it("doesn't have the old property", async () => {
      assert(!('content' in updated.object))
    })
    it('has the same published property', async () => {
      assert.equal(updated.object.published, created.object.published)
    })
    it('has a new updated property', async () => {
      assert.notEqual(updated.object.updated, created.object.updated)
    })
    it('can fetch the updated note', async () => {
      const res = await fetch(updated.object.id, {
        headers: { Authorization: `Bearer ${token1}` }
      })
      const fetched = await res.json()
      assert.equal(updated.object.id, fetched.id)
      assert.equal('Note', fetched.type)
      assert.equal(contentMap.en, fetched.contentMap.en)
      assert.equal(contentMap.fr, fetched.contentMap.fr)
      assert(!('content' in fetched))
    })
  })

  describe('Delete Activity', () => {
    let actor1 = null
    let token1 = null
    let created = null
    let deleted = null
    before(async () => {
      [actor1, token1] = await registerActor()
      const source = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          content: 'My dog has fleas.'
        }
      }
      const res = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(source)
      })
      created = await res.json()
      const deleteSource = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Delete',
        object: created.object.id
      }
      const deleteRes = await fetch(actor1.outbox.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json; charset=utf-8',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify(deleteSource)
      })
      deleted = await deleteRes.json()
    })
    it('has the same object id', async () => {
      assert.equal(created.object.id, deleted.object.id)
    })
    it('is a Tombstone', async () => {
      assert.equal('Tombstone', deleted.object.type)
    })
    it('has a summaryMap property', async () => {
      assert(deleted.object?.summaryMap?.en)
    })
    it('can fetch the Tombstone', async () => {
      const res = await fetch(deleted.object.id, {
        headers: { Authorization: `Bearer ${token1}` }
      })
      assert.equal(410, res.status)
      const fetched = await res.json()
      assert.equal(deleted.object.id, fetched.id)
      assert.equal('Tombstone', fetched.type)
      assert.equal('Note', fetched.formerType)
      assert(fetched.deleted)
      assert(fetched.updated)
      assert(fetched.published)
      assert(fetched.summaryMap?.en)
    })
  })

  describe('Add Activity', () => {
    let actor1 = null
    let token1 = null
    let createdCollection = null
    let createdNote = null
    before(async () => {
      [actor1, token1] = await registerActor()
      createdNote = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Buy some milk'
          }
        }
      })
      createdCollection = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Collection',
          nameMap: {
            en: 'TODO list'
          },
          items: []
        }
      })
      await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Add',
        object: createdNote.object.id,
        target: createdCollection.object.id
      })
    })
    it('adds an object to a collection', async () => {
      const res = await fetch(createdCollection.object.id, {
        headers: { Authorization: `Bearer ${token1}` }
      })
      const fetched = await res.json()
      assert(fetched.items.some(item => item.id === createdNote.object.id))
    })
  })

  describe('Remove Activity', () => {
    let actor1 = null
    let token1 = null
    let createdCollection = null
    let createdNote1 = null
    let createdNote2 = null
    before(async () => {
      [actor1, token1] = await registerActor()
      createdNote1 = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Buy some milk'
          }
        }
      })
      createdNote2 = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Clean the garage'
          }
        }
      })
      createdCollection = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Create',
        object: {
          type: 'Collection',
          nameMap: {
            en: 'TODO list'
          },
          items: []
        }
      })
      await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Add',
        object: createdNote1.object.id,
        target: createdCollection.object.id
      })
      await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Add',
        object: createdNote2.object.id,
        target: createdCollection.object.id
      })
      await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Remove',
        object: createdNote1.object.id,
        target: createdCollection.object.id
      })
    })
    it('removes an object from a collection', async () => {
      const res = await fetch(createdCollection.object.id, {
        headers: { Authorization: `Bearer ${token1}` }
      })
      const fetched = await res.json()
      assert(fetched.items.every(item => item.id !== createdNote1.object.id))
    })
    it('leaves other objects in the collection', async () => {
      const res = await fetch(createdCollection.object.id, {
        headers: { Authorization: `Bearer ${token1}` }
      })
      const fetched = await res.json()
      assert(fetched.items.some(item => item.id === createdNote2.object.id))
    })
  })

  describe('Like Activity', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    let createdNote1 = null
    let liked = null
    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      createdNote1 = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'My dog has fleas.'
          }
        }
      })
      liked = await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Like',
        object: createdNote1.object.id
      })
    })

    it("appears in the object's likes", async () => {
      const note1 = await (await fetch(createdNote1.object.id)).json()
      const likes = await (await fetch(note1.likes.id)).json()
      const likesPage = await (await fetch(likes.first.id)).json()
      assert(likesPage.orderedItems.some(activity => activity.id === liked.id))
    })

    it("object's likes count is 1", async () => {
      const note1 = await (await fetch(createdNote1.object.id)).json()
      const likes = await (await fetch(note1.likes.id)).json()
      assert.equal(likes.totalItems, 1)
    })

    it("appears in the liking actor's liked stream", async () => {
      const likedStream = await (await fetch(actor2.liked.id)).json()
      const likedPage = await (await fetch(likedStream.first.id)).json()
      assert(likedPage.orderedItems.some(obj => obj.id === createdNote1.object.id))
    })

    it("actor's liked count is 1", async () => {
      const likedStream = await (await fetch(actor2.liked.id)).json()
      assert.equal(likedStream.totalItems, 1)
    })
  })

  describe('Block Activity', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Follow',
        object: actor1.id
      })
      await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: [actor2.id],
        type: 'Block',
        object: actor2.id
      })
    })

    it("other appears in the actor's blocked", async () => {
      const blockedStream = await (await fetch(actor1.blocked.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const blockedPage = await (await fetch(blockedStream.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(blockedPage.orderedItems.some(actor => actor.id === actor2.id))
    })

    it("other does not appear in the actor's followers", async () => {
      const followersStream = await (await fetch(actor1.followers.id)).json()
      const followersPage = await (await fetch(followersStream.first.id)).json()
      assert(followersPage.orderedItems.every(actor => actor.id !== actor2.id))
    })

    it("actor does not appear in the other's following", async () => {
      const followingStream = await (await fetch(actor2.following.id)).json()
      const followingPage = await (await fetch(followingStream.first.id)).json()
      assert(followingPage.orderedItems.every(actor => actor.id !== actor1.id))
    })

    it("other can't send to actor", async () => {
      const created = await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: [actor1.id],
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Hello there.'
          }
        }
      })
      const inboxStream = await (await fetch(actor1.inbox.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const inboxPage = await (await fetch(inboxStream.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(inboxPage.orderedItems.every(obj => obj.id !== created.object.id))
    })

    it("other can't like actor note", async () => {
      const created1 = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: 'https://www.w3.org/ns/activitystreams#Public',
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Here are my thoughts.'
          }
        }
      })
      const res = await fetch(actor2.outbox.id, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/activity+json'
        },
        body: JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          to: 'https://www.w3.org/ns/activitystreams#Public',
          type: 'Like',
          object: created1.object.id
        })
      })
      assert.strictEqual(res.status, 400)
    })

    it("other can't read actor profile", async () => {
      const res = await fetch(actor1.id, { headers: { Authorization: `Bearer ${token2}` } })
      assert.strictEqual(res.status, 403)
    })

    it("other can't read actor outbox", async () => {
      const res = await fetch(actor1.outbox.id, { headers: { Authorization: `Bearer ${token2}` } })
      assert.strictEqual(res.status, 403)
    })

    it("other can't read actor note", async () => {
      const created = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: 'https://www.w3.org/ns/activitystreams#Public',
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Hello there.'
          }
        }
      })
      const res = await fetch(created.object.id, { headers: { Authorization: `Bearer ${token2}` } })
      assert.strictEqual(res.status, 403)
    })
  })

  describe('replies collection', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    let createNote = null
    let createReply = null

    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      createNote = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Hello world!'
          }
        }
      })
      createReply = await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Create',
        object: {
          inReplyTo: createNote.object.id,
          type: 'Note',
          contentMap: {
            en: 'Hello back!'
          }
        }
      })
    })

    it("reply appears in original's replies", async () => {
      const repliesStream = await (await fetch(createNote.object.replies.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const repliesPage = await (await fetch(repliesStream.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(repliesPage.orderedItems.some(reply => reply.id === createReply.object.id))
    })
  })

  describe('Announce activity', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    let createNote = null
    let announce = null

    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      createNote = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Hello world!'
          }
        }
      })
      announce = await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Announce',
        object: createNote.object.id
      })
    })

    it("Announce appears in original's shares", async () => {
      const sharesStream = await (await fetch(createNote.object.shares.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const sharesPage = await (await fetch(sharesStream.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(sharesPage.orderedItems.some(share => share.id === announce.id))
    })
  })

  describe('Undo Like activity', () => {
    let actor1 = null
    let token1 = null
    let actor2 = null
    let token2 = null
    let createNote = null
    let like = null
    before(async () => {
      [actor1, token1] = await registerActor();
      [actor2, token2] = await registerActor()
      createNote = await doActivity(actor1, token1, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Create',
        object: {
          type: 'Note',
          contentMap: {
            en: 'Hello world!'
          }
        }
      })
      like = await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Like',
        object: createNote.object.id
      })
      await doActivity(actor2, token2, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        type: 'Undo',
        object: like.id
      })
    })

    it("object is not in actor's liked", async () => {
      const likedStream = await (await fetch(actor2.liked.id, { headers: { Authorization: `Bearer ${token2}` } })).json()
      const likedPage = await (await fetch(likedStream.first.id, { headers: { Authorization: `Bearer ${token2}` } })).json()
      assert(likedPage.orderedItems.every(obj => obj.id !== createNote.object.id))
    })

    it("like activity is not in object's likes", async () => {
      const likesStream = await (await fetch(createNote.object.likes.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      const likesPage = await (await fetch(likesStream.first.id, { headers: { Authorization: `Bearer ${token1}` } })).json()
      assert(likesPage.orderedItems.every(act => act.id !== like.id))
    })
  })
})
