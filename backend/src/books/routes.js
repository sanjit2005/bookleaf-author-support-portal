import { Router } from 'express';
import { Book } from '../models/index.js';
import { authenticate, requireRole, resolveAuthor } from '../auth/middleware.js';
import { bookDetailsDTO, BOOK_DETAIL_FIELDS } from '../db/serialization.js';
import { pagination } from '../http/pagination.js';
export function createBooksRouter({models={Book},auth={authenticate,requireRole,resolveAuthor}}={}) {
  const {Book}=models;
  const {authenticate,requireRole,resolveAuthor}=auth;
  async function listBooks(req,res,filter,includeAuthor) {
    const paging=pagination(req.query);
    if(!paging) return res.status(400).json({error:'Invalid pagination or query parameters'});
    let query=Book.find(filter).select(BOOK_DETAIL_FIELDS.join(' ')+(includeAuthor?' author':'')+' -_id')
      .sort({book_id:1,_id:1}).skip(paging.offset).limit(paging.limit);
    if(includeAuthor) query=query.populate({path:'author',select:'author_id name'});
    const [books,total]=await Promise.all([query.lean(),Book.countDocuments(filter)]);
    res.json({books:books.map(book=>bookDetailsDTO(book,{includeAuthor})),pagination:{page:paging.page,limit:paging.limit,total,totalPages:Math.ceil(total/paging.limit)}});
  }
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/me/books',authenticate,requireRole('author'),resolveAuthor,async(req,res)=>{
    await listBooks(req,res,{author:req.auth.authorId},false);
  });
  router.get('/me/books/:bookId',authenticate,requireRole('author'),resolveAuthor,async(req,res)=>{
    const bookId=req.params.bookId;
    if(bookId.length>200||!/^BK\d+$/.test(bookId)) return res.status(400).json({error:'Invalid book ID'});
    if(Object.keys(req.query).length) return res.status(400).json({error:'Invalid query parameters'});
    const book=await Book.findOne({book_id:bookId,author:req.auth.authorId}).select(BOOK_DETAIL_FIELDS.join(' ')+' -_id').lean();
    if(!book) return res.status(404).json({error:'Book not found'});
    res.json({book:bookDetailsDTO(book)});
  });
  router.get('/admin/books',authenticate,requireRole('admin'),async(req,res)=>{
    await listBooks(req,res,{},true);
  });
  return router;
}
