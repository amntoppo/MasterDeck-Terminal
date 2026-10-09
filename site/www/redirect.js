// Every request to www goes to the bare domain, keeping its path and query.
export default {
  fetch(request) {
    const url = new URL(request.url)
    return Response.redirect(`https://masterdeck.dev${url.pathname}${url.search}`, 301)
  },
}
