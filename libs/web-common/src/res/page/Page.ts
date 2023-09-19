import { ResponseDto } from '../../decorator/ResponseDto';
import { ApiProperty } from '@nestjs/swagger';

@ResponseDto()
export class Page<T> {
  private readonly _pageNumber: number;
  private readonly _totalCount: number;
  private readonly _pageSize: number;
  private readonly _totalPage: number;
  private readonly _items: T[];

  constructor(
    pageNumber: number,
    totalCount: number,
    pageSize: number,
    items: T[],
  ) {
    this._pageNumber = pageNumber;
    this._totalCount = totalCount;
    this._pageSize = pageSize;
    this._totalPage = Math.ceil(totalCount / pageSize);
    this._items = items;
  }

  @ApiProperty()
  get pageNumber(): number {
    return this._pageNumber;
  }

  @ApiProperty()
  get totalCount(): number {
    return this._totalCount;
  }

  @ApiProperty()
  get pageSize(): number {
    return this._pageSize;
  }

  @ApiProperty()
  get totalPage(): number {
    return this._totalPage;
  }

  @ApiProperty()
  get items(): T[] {
    return this._items;
  }
}
